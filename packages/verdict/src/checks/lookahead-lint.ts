/**
 * Deterministic source lint for the leak patterns LLM-written backtests
 * inherit from the tutorials they were trained on. Pattern rules are
 * heuristics and say so in their findings; they prove a *suspect construct
 * exists*, not that the strategy is leak-free when silent.
 * @module @dsh-trading/verdict
 */

export interface LintFinding {
  ruleId: string
  severity: 'error' | 'warn'
  file: string
  line: number
  excerpt: string
  why: string
  fix: string
}

interface LintRule {
  id: string
  severity: 'error' | 'warn'
  pattern: RegExp
  /** Extra per-line guard; return false to suppress the hit. */
  guard?: (line: string) => boolean
  why: string
  fix: string
}

/**
 * The rule set, additive-only by id. Sources: the leak checklist the
 * r/algotrading community wrote in comment threads, made executable.
 */
export const LINT_RULES: readonly LintRule[] = [
  {
    id: 'LK001',
    severity: 'error',
    pattern: /\bshift\s*\(\s*-\s*\d/,
    why: 'shift(-n) pulls FUTURE rows into the current row: the classic lookahead leak.',
    fix: 'Shift features forward (shift(+n)) or compute signals on data available at bar open.',
  },
  {
    id: 'LK002',
    severity: 'error',
    pattern: /rolling\s*\([^)]*center\s*=\s*True/,
    why: 'A centered rolling window averages over bars that have not happened yet at decision time.',
    fix: 'Drop center=True; trailing windows only.',
  },
  {
    id: 'LK003',
    severity: 'error',
    pattern: /np\.roll\s*\([^)]*,\s*-\s*\d/,
    why: 'np.roll with a negative shift wraps future values into the present (and wraps the array tail to the head).',
    fix: 'Use explicit trailing indexing; never negative rolls in signal code.',
  },
  {
    id: 'LK004',
    severity: 'warn',
    pattern: /\bbfill\s*\(|fillna\s*\([^)]*(method\s*=\s*['"]bfill['"]|['"]backfill['"])/,
    why: 'Backfilling copies FUTURE observations into past gaps — a quiet leak through missing data.',
    fix: 'Forward-fill (ffill) or drop the gap rows.',
  },
  {
    id: 'LK005',
    severity: 'warn',
    pattern: /\.fit\s*\(\s*(df|X|data|features)\b/,
    guard: line => !/train/i.test(line),
    why: 'Fitting a scaler/model on the full dataset leaks test-period statistics into the training period.',
    fix: 'Fit on the training slice only; transform the rest.',
  },
  {
    id: 'LK006',
    severity: 'warn',
    pattern: /\blead\s*\(/,
    why: 'lead() references future rows (R/polars/SQL window vocabulary).',
    fix: 'Confirm the lead() target is a label being predicted, not a feature.',
  },
]

/** Does this line start as a comment? (#, //, block-comment continuations.) */
function isCommentLine(stripped: string): boolean {
  return /^(#|\/\/|\*|\/\*|--|'''|\"\"\")/.test(stripped)
}

/** Lint one source text. `file` is only used to label findings. */
export function lintSource(file: string, source: string): LintFinding[] {
  const findings: LintFinding[] = []
  const lines = source.split(/\r?\n/)
  lines.forEach((line, index) => {
    const stripped = line.trim()
    // Comment lines still count — commented-out leaks tend to come back —
    // but only as warnings: prose ABOUT a leak must not convict the file.
    const comment = isCommentLine(stripped)
    for (const rule of LINT_RULES) {
      if (!rule.pattern.test(line)) continue
      if (rule.guard && !rule.guard(line)) continue
      findings.push({
        ruleId: rule.id,
        severity: comment ? 'warn' : rule.severity,
        file,
        line: index + 1,
        excerpt: stripped.slice(0, 160),
        why: comment ? `(in a comment) ${rule.why} Commented-out leaks tend to come back — confirm it stays dead.` : rule.why,
        fix: rule.fix,
      })
    }
  })
  return findings
}
