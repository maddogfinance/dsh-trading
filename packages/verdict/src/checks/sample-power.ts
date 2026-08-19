/**
 * Sample-size power math: can this many trades distinguish the claimed edge
 * from a coin flip at all? When the answer is no, the honest verdict is
 * NOT PROVEN — not a prettier Sharpe.
 * @module @dsh-trading/verdict
 */

export interface SamplePowerResult {
  trades: number
  observedWinRate: number
  /** Wilson 95% interval for the win rate. */
  winRateCi95: { low: number; high: number }
  /** Minimal detectable edge used for the power question. */
  minDetectableEdge: number
  /** Trades required to detect that win-rate edge (two-sided alpha 0.05, power 0.8). */
  requiredTrades: number
  /** Trades required to detect the OBSERVED mean return against its own variance. */
  requiredTradesMeanReturn: number
  powered: boolean
}

/**
 * Acklam's rational approximation to the inverse normal CDF; relative error
 * < 1.15e-9 over (0, 1). Deterministic and dependency-free.
 */
export function inverseNormalCdf(p: number): number {
  if (p <= 0 || p >= 1) throw new Error(`inverseNormalCdf: p must be in (0,1), got ${p}`)
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239]
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const pLow = 0.02425
  let q: number
  let r: number
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
  }
  if (p <= 1 - pLow) {
    q = p - 0.5
    r = q * q
    return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q /
      (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
  }
  q = Math.sqrt(-2 * Math.log(1 - p))
  return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
    ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
}

/**
 * Trades needed to detect a win-rate edge `delta` over a known `baseline`,
 * two-sided test at `alpha`, at `power`. One-sample normal approximation
 * against the fixed baseline.
 */
export function requiredTrades(
  delta: number,
  options: { baseline?: number; alpha?: number; power?: number } = {},
): number {
  if (!(delta > 0)) throw new Error('minimal detectable edge must be > 0')
  const p0 = options.baseline ?? 0.5
  if (p0 + delta >= 1) throw new Error(`baseline ${p0} + edge ${delta} reaches 1 — no sample size can test an impossible win rate`)
  const p1 = p0 + delta
  const alpha = options.alpha ?? 0.05
  const power = options.power ?? 0.8
  const zA = inverseNormalCdf(1 - alpha / 2)
  const zB = inverseNormalCdf(power)
  const n = ((zA * Math.sqrt(p0 * (1 - p0)) + zB * Math.sqrt(p1 * (1 - p1))) / delta) ** 2
  return Math.ceil(n)
}

/** Wilson score interval for a binomial proportion. */
export function wilsonInterval(wins: number, n: number, z = 1.959964): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 1 }
  const pHat = wins / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const centre = (pHat + z2 / (2 * n)) / denom
  const margin = (z * Math.sqrt((pHat * (1 - pHat)) / n + z2 / (4 * n * n))) / denom
  return { low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) }
}

/**
 * Assess whether `tradeReturns` is a sample big enough to mean anything —
 * on BOTH dimensions: win-rate edge (vs the baseline) and mean return (vs
 * its own variance). `powered` requires both; an asymmetric-payoff strategy
 * whose edge lives in the tail cannot pass on the win-rate count alone.
 */
export function samplePower(
  tradeReturns: readonly number[],
  options: { minDetectableEdge?: number; baseline?: number } = {},
): SamplePowerResult {
  const minDetectableEdge = options.minDetectableEdge ?? 0.05
  if (!(minDetectableEdge > 0) || minDetectableEdge > 0.5) {
    throw new Error(`minDetectableEdge must be in (0, 0.5] as a probability (e.g. 0.05 for 5pp), got ${minDetectableEdge}`)
  }
  const n = tradeReturns.length
  const wins = tradeReturns.filter(r => r > 0).length
  const required = requiredTrades(minDetectableEdge, options.baseline !== undefined ? { baseline: options.baseline } : {})

  // Mean-return dimension: n needed so the observed mean clears its own
  // noise, n >= ((zA+zB) * sigma / |mu|)^2. A zero mean needs infinite n.
  const mu = n === 0 ? 0 : tradeReturns.reduce((s, r) => s + r, 0) / n
  const variance = n < 2 ? Number.POSITIVE_INFINITY
    : tradeReturns.reduce((s, r) => s + (r - mu) ** 2, 0) / (n - 1)
  const zA = inverseNormalCdf(0.975)
  const zB = inverseNormalCdf(0.8)
  const requiredMean = mu === 0 || !Number.isFinite(variance)
    ? Number.POSITIVE_INFINITY
    : Math.ceil(((zA + zB) * Math.sqrt(variance) / Math.abs(mu)) ** 2)

  return {
    trades: n,
    observedWinRate: n === 0 ? Number.NaN : wins / n,
    winRateCi95: wilsonInterval(wins, n),
    minDetectableEdge,
    requiredTrades: required,
    requiredTradesMeanReturn: requiredMean,
    powered: n >= required && n >= requiredMean,
  }
}
