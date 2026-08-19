/**
 * The evaluation harness: deterministic checks over backtest artifacts. The
 * model proposes results; this plugin disposes of the ones that could not be
 * true, and refuses to certify the ones the sample cannot support. Every
 * check is plain seeded code — no LLM grades its own homework here.
 *
 * Research only, like the rest of dsh-trading: verdicts judge evidence
 * quality; nothing forecasts, recommends, or trades.
 * @module @dsh-trading/verdict
 */

import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { parseArtifact, TIMEFRAME_MS, tradeReturn } from './artifact.js'
import type { BacktestArtifact } from './artifact.js'
import { lintSource, LINT_RULES } from './checks/lookahead-lint.js'
import type { LintFinding } from './checks/lookahead-lint.js'
import { validateFills } from './checks/fill-validation.js'
import { effectiveTrades } from './checks/independence.js'
import { randomBaseline } from './checks/random-baseline.js'
import { samplePower } from './checks/sample-power.js'
import {
  assembleReport, baselineCheck, costsCheck, fillCheck, fillModelCheck, independenceCheck,
  lintCheck, plausibilityCheck, powerCheck, renderReport,
} from './report.js'
import type { CheckResult, VerdictReport } from './report.js'

export { parseArtifact, TIMEFRAME_MS, tradeReturn } from './artifact.js'
export type { ArtifactCosts, ArtifactTrade, BacktestArtifact } from './artifact.js'
export { lintSource, LINT_RULES } from './checks/lookahead-lint.js'
export type { LintFinding } from './checks/lookahead-lint.js'
export { barIndexAt, validateFills } from './checks/fill-validation.js'
export type { FillIssue, FillValidationResult } from './checks/fill-validation.js'
export { effectiveTrades } from './checks/independence.js'
export type { EffectiveWindow, IndependenceResult } from './checks/independence.js'
export { mulberry32, randomBaseline } from './checks/random-baseline.js'
export type { RandomBaselineResult } from './checks/random-baseline.js'
export { inverseNormalCdf, requiredTrades, samplePower, wilsonInterval } from './checks/sample-power.js'
export type { SamplePowerResult } from './checks/sample-power.js'
export {
  assembleReport, baselineCheck, BASELINE_PASS_PERCENTILE, BLIND_SPOTS, costsCheck, fillCheck,
  fillModelCheck, independenceCheck, lintCheck, plausibilityCheck, powerCheck, renderReport,
} from './report.js'
export type { CheckResult, CheckStatus, Verdict, VerdictReport } from './report.js'

export const name = 'verdict'
export const inject = ['tools', 'marketData']

export interface Config {
  /** Random-baseline simulations per audit. */
  simulations: number
  /** PRNG seed; identical inputs + seed give identical reports. */
  seed: number
}

export const Config: z<Config> = z.object({
  simulations: z.number().default(1000),
  seed: z.number().default(42),
})

/** Cap on strategy source files read per call. */
const MAX_CODE_FILES = 16
/** Cap on characters scanned per source file. */
const MAX_CODE_CHARS = 512 * 1024
/** Bars of slack around the trade span when fetching audit candles — wide
 * enough to survive weekend/holiday gaps ahead of the first entry. */
const FETCH_SLACK_BARS = 5

function resolvePath(p: string): string {
  return isAbsolute(p) ? p : resolve(process.cwd(), p)
}

interface LintScan {
  findings: LintFinding[]
  scanned: number
  unreadable: string[]
  notes: string[]
}

async function lintPaths(paths: readonly string[]): Promise<LintScan> {
  const findings: LintFinding[] = []
  const unreadable: string[] = []
  const notes: string[] = []
  let scanned = 0
  if (paths.length > MAX_CODE_FILES) {
    notes.push(`${paths.length - MAX_CODE_FILES} file(s) beyond the ${MAX_CODE_FILES}-file cap were NOT scanned`)
  }
  for (const p of paths.slice(0, MAX_CODE_FILES)) {
    try {
      const text = await readFile(resolvePath(p), 'utf8')
      if (text.length > MAX_CODE_CHARS) {
        notes.push(`${p}: only the first ${MAX_CODE_CHARS} characters were scanned`)
      }
      findings.push(...lintSource(p, text.slice(0, MAX_CODE_CHARS)))
      scanned += 1
    } catch {
      unreadable.push(p)
    }
  }
  return { findings, scanned, unreadable, notes }
}

export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'lint_strategy_code',
    description: `Scan strategy/backtest source files (read from disk as given, max ${MAX_CODE_FILES}) for known lookahead-leak patterns: negative shift, centered rolling windows, backfill, full-data scaler fits. Deterministic pattern rules — a hit is a suspect construct to inspect, comment-line hits are downgraded to warnings, and silence is not proof of correctness. Read-only.`,
    parameters: {
      paths: {
        type: 'array', required: true, items: { type: 'string' },
        description: `Source files to scan (max ${MAX_CODE_FILES}), relative to the working directory or absolute.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scanned: { type: 'number', required: true },
          unreadable: { type: 'array', items: { type: 'string' } },
          notes: { type: 'array', items: { type: 'string' } },
          findings: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                ruleId: { type: 'string', required: true },
                severity: { type: 'string', required: true },
                file: { type: 'string', required: true },
                line: { type: 'number', required: true },
                excerpt: { type: 'string', required: true },
                why: { type: 'string', required: true },
                fix: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const parts: string[] = []
        if (value.findings.length === 0) {
          parts.push(`No known leak patterns in ${value.scanned} file(s). (${LINT_RULES.length} pattern rules — silence is not proof.)`)
        } else {
          parts.push(value.findings.map(f => `[${f.ruleId}/${f.severity}] ${f.file}:${f.line} \`${f.excerpt}\`\n    ${f.why}\n    Fix: ${f.fix}`).join('\n'))
        }
        for (const u of value.unreadable ?? []) parts.push(`UNREADABLE: ${u}`)
        for (const n of value.notes ?? []) parts.push(`NOTE: ${n}`)
        return [{ type: 'text', text: parts.join('\n') }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      const { findings, scanned, unreadable, notes } = await lintPaths(args.paths)
      return {
        scanned,
        ...unreadable.length > 0 ? { unreadable } : {},
        ...notes.length > 0 ? { notes } : {},
        findings,
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Lint strategy code', kind: 'read', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'audit_backtest',
    description: 'Audit a backtest artifact (JSON: {version:1, symbol, timeframe, trades:[{entryTime, exitTime, side, entryPrice, exitPrice}], costs?}) against real candles from the mounted market-data provider. Checks: fills inside the true bar range, trade independence (duplicates/overlaps), a seeded random-entry baseline ranked on close-to-close shadow returns, the self-reported vs shadow fill-model gap, sample-size power on both win-rate and mean-return dimensions, win-rate plausibility, and cost declaration; optional lookahead lint over codePaths (read from disk as given). Returns a verdict that can honestly be NOT PROVEN and lists its own blind spots. It never certifies profitability.',
    parameters: {
      artifactPath: { type: 'string', description: 'Path to the artifact JSON file. Provide this or artifactJson.' },
      artifactJson: { type: 'string', description: 'The artifact as an inline JSON string. Provide this or artifactPath.' },
      codePaths: { type: 'array', items: { type: 'string' }, description: `Strategy/backtest source files to lint alongside the audit (max ${MAX_CODE_FILES}).` },
      minDetectableEdge: { type: 'number', description: 'Win-rate edge the sample-size check tests for, as a PROBABILITY in (0, 0.5] — e.g. 0.05 for 5 percentage points. Default 0.05.' },
      priceTolerancePct: { type: 'number', description: 'Extra price tolerance (percent) for the fill-range check, for artifacts backtested on a different data vendor. Default 0 (exact against this provider).' },
      provider: { type: 'string', description: 'Market-data provider id. Omit for the default provider.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          version: { type: 'number', required: true },
          symbol: { type: 'string', required: true },
          timeframe: { type: 'string', required: true },
          provider: { type: 'string', required: true },
          trades: { type: 'number', required: true },
          meanTradeReturnPct: { type: 'number', required: true },
          verdict: { type: 'string', required: true },
          headline: { type: 'string', required: true },
          checks: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                status: { type: 'string', required: true },
                summary: { type: 'string', required: true },
                details: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderReport(value as VerdictReport) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      if (!args.artifactPath && !args.artifactJson) {
        throw new Error('provide artifactPath or artifactJson')
      }
      const raw = args.artifactPath
        ? await readFile(resolvePath(args.artifactPath), 'utf8')
        : args.artifactJson!
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        // Deliberately no snippet echo: the parse error would otherwise quote
        // the head of whatever file the path pointed at.
        throw new Error('artifact is not valid JSON')
      }
      const artifact = parseArtifact(parsed)
      if (args.minDetectableEdge !== undefined && !(args.minDetectableEdge > 0 && args.minDetectableEdge <= 0.5)) {
        throw new Error(`minDetectableEdge must be in (0, 0.5] as a probability (got ${args.minDetectableEdge})`)
      }

      // The artifact promises entry/exit times anywhere INSIDE their bars, and
      // providers filter by bar-open time — so pad the window by whole bars,
      // or the first trade's own entry bar gets cropped out of its audit.
      const periodMs = TIMEFRAME_MS[artifact.timeframe]
      let minEntry = Number.POSITIVE_INFINITY
      let maxExit = Number.NEGATIVE_INFINITY
      for (const trade of artifact.trades) {
        minEntry = Math.min(minEntry, Date.parse(trade.entryTime))
        maxExit = Math.max(maxExit, Date.parse(trade.exitTime))
      }
      const start = new Date(minEntry - FETCH_SLACK_BARS * periodMs).toISOString()
      const end = new Date(maxExit + periodMs).toISOString()
      const providerId = ctx.marketData.provider(args.provider).id
      const bars = await ctx.marketData.getOhlcv(
        { symbol: artifact.symbol, timeframe: artifact.timeframe, start, end },
        args.provider,
      )
      if (bars.length === 0) {
        throw new Error(`provider '${providerId}' returned no candles for ${artifact.symbol} ${artifact.timeframe} in [${start}, ${end}] — audit needs the same data the backtest ran on`)
      }

      const checks: CheckResult[] = []
      if (args.codePaths && args.codePaths.length > 0) {
        const { findings, scanned, unreadable, notes } = await lintPaths(args.codePaths)
        checks.push(lintCheck(findings, scanned, unreadable, notes))
      }
      checks.push(fillCheck(validateFills(artifact.trades, bars, {
        durationMs: periodMs,
        ...args.priceTolerancePct !== undefined ? { priceTolerancePct: args.priceTolerancePct } : {},
      })))

      const barTimes = bars.map(b => Date.parse(b.time))
      const independence = effectiveTrades(artifact.trades, barTimes, periodMs)
      checks.push(independenceCheck(independence))

      const baseline = randomBaseline(independence.kept, bars, {
        simulations: config.simulations,
        seed: config.seed,
      })
      checks.push(baselineCheck(baseline))
      checks.push(fillModelCheck(baseline))

      const effectiveReturns = independence.kept.map(w => tradeReturn(w.trade))
      const power = samplePower(
        effectiveReturns,
        args.minDetectableEdge !== undefined ? { minDetectableEdge: args.minDetectableEdge } : {},
      )
      checks.push(powerCheck(power))
      checks.push(plausibilityCheck(power))
      checks.push(costsCheck(artifact))

      return assembleReport(artifact, checks, providerId)
    },
    presentCall: args => ({ card: 'generic', title: 'Audit backtest', kind: 'read', rawInput: args }),
  }))
}
