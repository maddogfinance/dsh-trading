/**
 * Assemble check results into the one thing this package exists to produce:
 * a verdict that is allowed to say NOT PROVEN — and that names, out loud,
 * what it cannot see.
 * @module @dsh-trading/verdict
 */

import type { BacktestArtifact } from './artifact.js'
import { tradeReturn } from './artifact.js'
import type { LintFinding } from './checks/lookahead-lint.js'
import type { FillValidationResult } from './checks/fill-validation.js'
import type { IndependenceResult } from './checks/independence.js'
import type { RandomBaselineResult } from './checks/random-baseline.js'
import type { SamplePowerResult } from './checks/sample-power.js'

export type CheckStatus = 'error' | 'warn' | 'not_proven' | 'pass' | 'skipped'

export interface CheckResult {
  id: string
  name: string
  status: CheckStatus
  summary: string
  details?: string[]
}

export type Verdict = 'DEFECTS_FOUND' | 'NOT_PROVEN' | 'NO_DEFECTS_FOUND'

export interface VerdictReport {
  version: 1
  symbol: string
  timeframe: string
  /** Market-data provider the audit candles came from. */
  provider: string
  trades: number
  meanTradeReturnPct: number
  verdict: Verdict
  headline: string
  checks: CheckResult[]
}

/** Percentile the baseline must clear before results leave the luck zone. */
export const BASELINE_PASS_PERCENTILE = 0.95
/** Fraction of close-priced entries above which we flag a fill-model smell. */
const CLOSE_FILL_WARN_RATIO = 0.6
/** Fraction of same-bar round trips above which fills are unverifiable. */
const SAME_BAR_NOT_PROVEN_RATIO = 0.5
/** Self-reported minus shadow mean return (per trade) that earns a warn / a NOT PROVEN. */
const FILL_GAP_WARN = 0.001
const FILL_GAP_NOT_PROVEN = 0.005
/** Overlap ratios that demote the sample from evidence to noise. */
const OVERLAP_WARN_RATIO = 0.3
const OVERLAP_ERROR_RATIO = 0.9
/** Checks whose absence means the verdict cannot rise above NOT PROVEN. */
const SUBSTANTIVE_CHECKS = ['fill-validation', 'random-baseline', 'sample-power'] as const

const round = (x: number, dp: number): number => {
  const f = 10 ** dp
  return Math.round(x * f) / f
}

/** Cap a details list, appending an honest count of what was cut. */
function capDetails(details: string[], cap = 20): string[] {
  if (details.length <= cap) return details
  return [...details.slice(0, cap), `…and ${details.length - cap} more not shown`]
}

export function lintCheck(
  findings: LintFinding[],
  filesScanned: number,
  unreadable: readonly string[] = [],
  notes: readonly string[] = [],
): CheckResult {
  const errors = findings.filter(f => f.severity === 'error')
  const warns = findings.filter(f => f.severity === 'warn')
  const details = capDetails(findings.map(f =>
    `[${f.ruleId}] ${f.file}:${f.line} \`${f.excerpt}\` — ${f.why} Fix: ${f.fix}`))
  if (unreadable.length > 0) {
    details.push(`unreadable: ${unreadable.join(', ')}`)
  }
  details.push(...notes)
  if (filesScanned === 0) {
    if (unreadable.length > 0) {
      return {
        id: 'lookahead-lint', name: 'Lookahead lint', status: 'warn',
        summary: `lint did NOT run — ${unreadable.length} path(s) could not be read`, details,
      }
    }
    return { id: 'lookahead-lint', name: 'Lookahead lint', status: 'skipped', summary: 'no source files provided' }
  }
  if (errors.length > 0) {
    return {
      id: 'lookahead-lint', name: 'Lookahead lint', status: 'error',
      summary: `${errors.length} lookahead leak pattern(s) in ${filesScanned} file(s) — the backtest reads the future`,
      details,
    }
  }
  if (warns.length > 0 || unreadable.length > 0 || notes.length > 0) {
    return {
      id: 'lookahead-lint', name: 'Lookahead lint', status: 'warn',
      summary: unreadable.length > 0
        ? `${warns.length} suspect construct(s); ${unreadable.length} path(s) unreadable — lint incomplete`
        : `${warns.length} suspect construct(s); each needs a human eye`,
      details,
    }
  }
  return {
    id: 'lookahead-lint', name: 'Lookahead lint', status: 'pass',
    summary: `no known leak patterns in ${filesScanned} file(s) (pattern rules — silence is not proof)`,
  }
}

export function fillCheck(result: FillValidationResult): CheckResult {
  const impossible = result.issues.filter(i => i.kind === 'impossible-entry-fill' || i.kind === 'impossible-exit-fill')
  const outside = result.tradesOutsideData
  const details = capDetails(result.issues.map(i => `trade[${i.tradeIndex}] ${i.kind}: ${i.detail}`))
  if (impossible.length > 0) {
    return {
      id: 'fill-validation', name: 'Fill validation', status: 'error',
      summary: `${impossible.length} fill(s) at prices this provider's bars never printed — if the backtest ran on a different data source, audit against that source`,
      details,
    }
  }
  if (outside > 0) {
    return {
      id: 'fill-validation', name: 'Fill validation', status: 'error',
      summary: `${outside} trade(s) fall outside the candle window — artifact and provider data disagree, fills unverifiable`,
      details,
    }
  }
  const sameBarRatio = result.sameBarCount / result.tradesChecked
  if (sameBarRatio > SAME_BAR_NOT_PROVEN_RATIO) {
    return {
      id: 'fill-validation', name: 'Fill validation', status: 'not_proven',
      summary: `${result.sameBarCount}/${result.tradesChecked} trades enter and exit inside one bar — by this check's own standard those fills are unverifiable at this timeframe`,
    }
  }
  const smells: string[] = []
  if (result.closeFillCount / result.tradesChecked >= CLOSE_FILL_WARN_RATIO) {
    smells.push(`${result.closeFillCount}/${result.tradesChecked} entries fill exactly at the bar close — signal-on-close + fill-on-close is unobtainable in live trading; use next-bar-open fills`)
  }
  if (result.sameBarCount > 0) {
    smells.push(`${result.sameBarCount} trade(s) enter and exit inside one bar — intrabar round trips need finer data than this timeframe to verify`)
  }
  if (smells.length > 0) {
    return { id: 'fill-validation', name: 'Fill validation', status: 'warn', summary: smells[0]!, details: smells }
  }
  return {
    id: 'fill-validation', name: 'Fill validation', status: 'pass',
    summary: `${result.tradesChecked} trade(s): every fill inside its bar's true range`,
  }
}

export function independenceCheck(result: IndependenceResult): CheckResult {
  const summaryBase = `${result.effective} independent same-side windows out of ${result.reported} reported trades`
  if (result.mapped > 0 && result.overlapRatio > OVERLAP_ERROR_RATIO) {
    return {
      id: 'independence', name: 'Trade independence', status: 'error',
      summary: `${summaryBase} — the sample is overwhelmingly duplicated/overlapping; these are not independent observations`,
    }
  }
  if (result.overlapRatio > OVERLAP_WARN_RATIO) {
    return {
      id: 'independence', name: 'Trade independence', status: 'warn',
      summary: `${summaryBase} — statistics below run on the independent subset`,
    }
  }
  return { id: 'independence', name: 'Trade independence', status: 'pass', summary: summaryBase }
}

export function baselineCheck(result: RandomBaselineResult): CheckResult {
  if (!Number.isFinite(result.percentile)) {
    return { id: 'random-baseline', name: 'Random baseline', status: 'skipped', summary: result.note }
  }
  const pctText = `close-to-close mean return ${round(result.shadowMeanReturn * 100, 3)}% sits at the ${round(result.percentile * 100, 1)}th percentile of ${result.simulations} random-entry twins (seed ${result.seed}, ${result.tradesUsed} independent trades)`
  if (result.percentile >= BASELINE_PASS_PERCENTILE) {
    return { id: 'random-baseline', name: 'Random baseline', status: 'pass', summary: pctText }
  }
  return {
    id: 'random-baseline', name: 'Random baseline', status: 'not_proven',
    summary: `${pctText} — indistinguishable from luck at the ${Math.round(BASELINE_PASS_PERCENTILE * 100)}% bar`,
    details: [`random twins: p05 ${round(result.simMeanReturns.p05 * 100, 3)}%, p50 ${round(result.simMeanReturns.p50 * 100, 3)}%, p95 ${round(result.simMeanReturns.p95 * 100, 3)}%`],
  }
}

/** Self-reported vs shadow (close-to-close) mean return: the fill-model gap. */
export function fillModelCheck(result: RandomBaselineResult): CheckResult {
  if (!Number.isFinite(result.shadowMeanReturn) || !Number.isFinite(result.selfReportedMeanReturn)) {
    return { id: 'fill-model', name: 'Fill model', status: 'skipped', summary: 'baseline did not run; fill-model gap not computed' }
  }
  const gap = result.selfReportedMeanReturn - result.shadowMeanReturn
  const gapText = `self-reported fills add ${round(gap * 10_000, 1)}bp/trade over close-to-close on the same bars`
  if (gap > FILL_GAP_NOT_PROVEN) {
    return {
      id: 'fill-model', name: 'Fill model', status: 'not_proven',
      summary: `${gapText} — the edge lives in intrabar fill placement, which this timeframe cannot verify`,
    }
  }
  if (gap > FILL_GAP_WARN) {
    return { id: 'fill-model', name: 'Fill model', status: 'warn', summary: `${gapText} — optimistic fill assumption; verify with finer data` }
  }
  return { id: 'fill-model', name: 'Fill model', status: 'pass', summary: `fill model consistent (${gapText})` }
}

export function powerCheck(result: SamplePowerResult): CheckResult {
  const ci = `win rate ${round(result.observedWinRate * 100, 1)}% (95% CI ${round(result.winRateCi95.low * 100, 1)}–${round(result.winRateCi95.high * 100, 1)}%)`
  const meanReq = Number.isFinite(result.requiredTradesMeanReturn) ? `${result.requiredTradesMeanReturn}` : 'unbounded'
  if (result.powered) {
    return {
      id: 'sample-power', name: 'Sample size', status: 'pass',
      summary: `${result.trades} independent trades; ${ci}; enough for a ${round(result.minDetectableEdge * 100, 1)}pp win-rate edge (needs ${result.requiredTrades}) and for the observed mean return (needs ${meanReq})`,
    }
  }
  return {
    id: 'sample-power', name: 'Sample size', status: 'not_proven',
    summary: `${result.trades} independent trades cannot support the claim — win-rate dimension needs ${result.requiredTrades}, mean-return dimension needs ${meanReq}; ${ci}`,
  }
}

/** Implausibly clean win rates deserve a flag, not applause. */
export function plausibilityCheck(result: SamplePowerResult): CheckResult {
  if (result.trades > 50 && result.winRateCi95.low > 0.9) {
    return {
      id: 'plausibility', name: 'Plausibility', status: 'warn',
      summary: `win-rate 95% CI lower bound ${round(result.winRateCi95.low * 100, 1)}% over ${result.trades} trades — gross-of-execution reality rarely looks like this; check for omitted losers`,
    }
  }
  return { id: 'plausibility', name: 'Plausibility', status: 'pass', summary: 'win-rate level is within gross-of-execution plausibility' }
}

export function costsCheck(artifact: BacktestArtifact): CheckResult {
  if (artifact.costs?.included) {
    return { id: 'costs', name: 'Costs', status: 'pass', summary: 'artifact declares fees/slippage included in reported prices' }
  }
  return {
    id: 'costs', name: 'Costs', status: 'warn',
    summary: 'returns are GROSS of fees and slippage (artifact declares none included) — live results will be worse',
  }
}

/** What this harness cannot see. Printed on every report, whatever the verdict. */
export const BLIND_SPOTS: readonly string[] = [
  'in-sample selection: it cannot see how many strategy variants were tried on this same window before this one was shown to it',
  'trade-list completeness: an artifact containing only the winning trades passes every check here',
  'fills finer than the declared timeframe: intrabar execution quality is invisible at this bar size',
]

/** Fold check results into the report. */
export function assembleReport(
  artifact: BacktestArtifact,
  checks: CheckResult[],
  provider = 'unknown',
): VerdictReport {
  if (checks.length === 0) {
    throw new Error('assembleReport: no checks were run — refusing to issue a verdict on nothing')
  }
  const returns = artifact.trades.map(tradeReturn)
  const meanPct = round((returns.reduce((s, r) => s + r, 0) / returns.length) * 100, 3)

  const hasError = checks.some(c => c.status === 'error')
  const hasNotProven = checks.some(c => c.status === 'not_proven')
  const substantiveSkipped = SUBSTANTIVE_CHECKS.filter(id =>
    !checks.some(c => c.id === id && c.status !== 'skipped'))
  const warnCount = checks.filter(c => c.status === 'warn').length

  const verdict: Verdict = hasError
    ? 'DEFECTS_FOUND'
    : hasNotProven || substantiveSkipped.length > 0
      ? 'NOT_PROVEN'
      : 'NO_DEFECTS_FOUND'
  const warnSuffix = warnCount > 0 ? ` ${warnCount} warning(s) remain unresolved below.` : ''
  const headline =
    verdict === 'DEFECTS_FOUND'
      ? 'Defects found: the reported results contain trades or code paths that could not exist live. Fix them before believing any metric.'
      : verdict === 'NOT_PROVEN'
        ? substantiveSkipped.length > 0 && !hasNotProven
          ? `Not proven: substantive check(s) did not run (${substantiveSkipped.join(', ')}) — a verdict without them would be worthless.${warnSuffix}`
          : `Not proven: no defect found, but this evidence cannot distinguish the results from luck. More (out-of-sample) trades, not more optimism.${warnSuffix}`
        : `No defects found at this sample size. This is NOT a certification of profitability — it means the results survived every check this harness knows, and it is blind to the limits listed at the bottom.${warnSuffix}`

  return {
    version: 1,
    symbol: artifact.symbol,
    timeframe: artifact.timeframe,
    provider,
    trades: artifact.trades.length,
    meanTradeReturnPct: meanPct,
    verdict,
    headline,
    checks,
  }
}

const STATUS_TAG: Record<CheckStatus, string> = {
  error: '[FAIL]',
  warn: '[WARN]',
  not_proven: '[NOT PROVEN]',
  pass: '[PASS]',
  skipped: '[SKIP]',
}

/** Plain-text rendering: what the model (and the human) reads. */
export function renderReport(report: VerdictReport): string {
  const lines: string[] = []
  lines.push(`VERDICT: ${report.verdict.replace(/_/g, ' ')} — ${report.symbol} ${report.timeframe} (provider: ${report.provider}), ${report.trades} trades, mean trade return ${report.meanTradeReturnPct}%`)
  lines.push(report.headline)
  lines.push('')
  for (const check of report.checks) {
    lines.push(`${STATUS_TAG[check.status]} ${check.name}: ${check.summary}`)
    for (const detail of check.details ?? []) lines.push(`    - ${detail}`)
  }
  lines.push('')
  lines.push('This harness cannot see:')
  for (const spot of BLIND_SPOTS) lines.push(`  - ${spot}`)
  return lines.join('\n')
}
